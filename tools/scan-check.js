/**
 * 바코드 스캔 루프의 **불변식 검사** 🔑
 * (개발용 · `node tools/scan-check.js [시나리오수] [시드] [--mutate=이름]`).
 *
 * 실기기가 없어도 루프는 셀 수 있다. 가짜 시계·가짜 카메라·가짜 디코더를 끼워
 * `scanner.js` 를 **그대로** 돌리고 「이건 절대 일어나면 안 된다」 를 센다.
 * 2026-09-17 에 실제로 났던 사고(한 파렛트가 2건으로 계수 · 준비 중 이탈 시 좀비 루프 ·
 * 중지 후 1건 유출)를 재현해 막는 것이 목적이다 (AGENT_LEARNING_LOG 참고).
 *
 * 테스트 러너를 들이지 않은 이유 🔑 - 이 프로젝트에 테스트 프레임워크가 없고,
 * 검사 대상이 **순수 함수 + 루프 하나**라 의존성 없는 스크립트로 충분하다
 * (`tools/checkflow-check.js` 와 같은 꼴).
 *
 *   S1 같은 값을 계속 검출해도 `repeatMs` 주기보다 자주 세지 않는다
 *   S2 **디코딩 실패가 섞여도 한 라벨이 2건으로 세어지지 않는다** (핵심 · 재발 방지)
 *      + 라벨을 떼었다 대면 그만큼 정확히 세어진다
 *   S3 성공 프레임이 싸져도 `reArmGap` 이 **짧아지지 않는다** (`cost` 는 미검출만)
 *   S4 한 tick 의 디코딩 총시간이 **예산 + 1회분**을 넘지 않는다
 *   S5 `stop()` 이 어느 `await` 사이에 와도 콜백·디코딩이 더 나오지 않는다 (세대 토큰)
 *   S6 강등이 진동하지 않는다 (2회 연속 초과에서만 1번 · 복귀 없음)
 *   S7 ROI 계획 - **가로 ≥ 0.72**(quiet zone) · 계획은 순열 · 1순위만 CODE_128 전용
 *   S8 줌 - 쓸 수 있는 단계가 2개 미만이면 **빈 배열**(UI 가 버튼을 숨긴다) · 범위 클램프
 *      + 안정화 대기 중에 멈춰도 `setZoomRaw` 가 끝난다 (UI 의 `zoomBusy` 가 풀린다)
 *   S9 합의(consensus)는 **연속** 프레임을 뜻한다 - 미검출이 끼면 처음부터 다시 센다
 *  S10 내장 인식기가 **예외를 던지면** ZXing 으로 갈아타고 인식이 재개된다 (과다 계수 0)
 *  S11 내장이 **늘 빈 결과**면 그림자 디코딩으로 읽고, 전환 전후의 계수가 어긋나지 않는다
 *
 * 🔑 **검사기를 믿기 전에 변이로 검사기를 검증한다.** `--mutate=이름` 은 원본을 건드리지 않고
 * 임시 폴더에 고친 사본을 만들어 돌린다 (`--mutate=list` 로 목록).
 *
 * 🔑 **ZXing 은 가짜로 갈아끼운다.** 실제 패키지는 브라우저 전용이라 노드에서 돌지 않는다.
 * 사본을 만들 때 `@zxing/*` 임포트만 아래 `ZXING_FAKE` 로 바꾼다 (변이와 같은 방식이고,
 * 바꾸는 곳은 **임포트 지정자 두 줄뿐**이다). 시작 자가 진단(`selfTest`)은 `Image`·`Blob`
 * 가 필요해 노드에서 모사할 수 없으므로 **브라우저에서 확인한다** (docs/testing.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'assets', 'js');

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const nums = args.filter((a) => !a.startsWith('--'));
const TOTAL = Number(nums[0] ?? 120);
const SEED = Number(nums[1] ?? 20260919) >>> 0;
const MUTATE = flags.find((a) => a.startsWith('--mutate='))?.slice(9) ?? '';

/* --------------------------------- 변이 목록 --------------------------------- */

/**
 * 일부러 깨는 방법들 - 각 항목은 **검사기가 잡아야 하는 결함** 하나에 대응한다.
 * 잡히지 않으면 그 검사 항목은 아무것도 세고 있지 않은 것이다.
 */
const MUTATIONS = {
    'cost-hit': {
        why: 'S3 - cost 이동평균에 성공 프레임을 섞는다 (reArmGap 이 짧아진다)',
        file: 'scan-calc.js',
        find: '    if (hit) return cost;\n',
        to: '',
    },
    'rearm-short': {
        why: 'S2 - 중복 판정 문턱을 0.6초로 되돌린다 (2026-09-17 사고 재현)',
        file: 'scan-calc.js',
        find: '    return Math.max(tune.reArmMs, tune.reArmFrames * Math.max(0, cost));',
        to: '    return 600;',
    },
    'roi-narrow': {
        why: 'S7 - ROI 가로 하한을 무시한다 (quiet zone 이 잘린다)',
        file: 'scan-calc.js',
        find: 'Math.max(ROI_MIN_W, roi.w)',
        to: 'Math.min(0.5, roi.w)',
    },
    'zoom-always': {
        why: 'S8 - 줌이 없는 기기에도 버튼 목록을 준다',
        file: 'scan-calc.js',
        find: '    return out.length > 1 ? out : [];',
        to: '    return out;',
    },
    'budget-off': {
        why: 'S4 - 예산을 보지 않고 ROI 를 전부 돌린다',
        file: 'scanner.js',
        find: '                if (i > 0 && used >= budget) break;',
        to: '',
    },
    'leak-stop': {
        why: 'S5 - 디코딩 뒤 running 재확인을 뺀다 (중지 후 1건 유출)',
        file: 'scanner.js',
        find: '                if (!running) return;\n'
            + '                const done = performance.now();',
        to: '                const done = performance.now();',
    },
    'throw-stop': {
        why: 'S5 - 디코딩이 예외를 던진 경로에서 running 재확인을 뺀다 (중지 뒤 좀비 타이머)',
        file: 'scanner.js',
        // 🔑 재확인이 **둘**이다 - catch 머리와 ZXing 전환(await) 뒤. 하나만 빼면 나머지가
        // 막아 주므로 결함이 드러나지 않는다. 같은 불변식을 지키는 짝이라 함께 뺀다
        edits: [
            {
                find: '            if (!running) return;\n'
                    + '            console.warn(\'바코드 인식 실패\'',
                to: '            console.warn(\'바코드 인식 실패\'',
            },
            {
                find: "            if (reader.native) await swapEngine('내장 인식기 오류로"
                    + " ZXing 으로 전환합니다.');\n            if (!running) return;\n",
                to: '',
            },
        ],
    },
    'settle-hang': {
        why: 'S8 - 줌 안정화를 resolve 없이 끊는다 (핀치가 영영 잠긴다)',
        file: 'scanner.js',
        find: '        if (done) done();',
        to: '',
    },
    'consensus-keep': {
        why: 'S9 - 미검출이 끼어도 합의 계수를 유지한다 (연속이 아닌데 통과한다)',
        file: 'scanner.js',
        find: '            agree = 0;\n            agreeCode = \'\';\n',
        to: '',
    },
    'no-fallback': {
        why: 'S10 - 내장이 예외를 던져도 ZXing 으로 갈아타지 않는다 (영원히 미검출)',
        file: 'scanner.js',
        find: "            if (reader.native) await swapEngine('내장 인식기 오류로 ZXing 으로 전환합니다.');\n",
        to: '',
    },
    'shadow-count': {
        why: 'S11 - 그림자 디코딩에 든 시간을 tick 소요시간에서 뺀다'
            + ' (cost 가 실제보다 싸져 문턱이 짧아지고 한 라벨이 2건이 된다)',
        file: 'scanner.js',
        find: '                used = performance.now() - began;\n'
            + '                shadowHit = Boolean(code);',
        to: '                shadowHit = Boolean(code);',
    },
    'downgrade-again': {
        why: 'S6 - 초과할 때마다 강등한다 (진동)',
        file: 'scan-calc.js',
        find: '    return !downgraded && overrun >= DOWNGRADE_AFTER;',
        to: '    return overrun >= 1;',
    },
};

if (MUTATE === 'list') {
    process.stdout.write('변이 목록\n');
    Object.entries(MUTATIONS).forEach(([k, m]) => process.stdout.write(`  ${k}\t${m.why}\n`));
    process.exit(0);
}

/**
 * 가짜 ZXing - 실제 패키지는 `document`·`HTMLCanvasElement` 를 쓰므로 노드에서 못 돌린다.
 * 디코딩 결과와 소요시간은 검사기가 전역(`__zxing`)으로 정한다.
 */
const ZXING_FAKE = `export class BrowserMultiFormatReader {
    constructor(hints) { this.hints = hints; }
    decodeFromCanvas() { return globalThis.__zxing(); }
}
export const DecodeHintType = { POSSIBLE_FORMATS: 'formats', TRY_HARDER: 'hard' };
export const BarcodeFormat = {
    CODE_128: 1, CODE_39: 2, ITF: 3, CODABAR: 4, EAN_13: 5, QR_CODE: 6,
};
`;

/**
 * 돌릴 사본을 임시 폴더에 만들고 그 경로를 돌려준다 (원본은 건드리지 않는다).
 * 변이가 없어도 사본을 만든다 - ZXing 임포트를 가짜로 바꿔야 하기 때문이다.
 */
function sourceDir() {
    const m = MUTATE ? MUTATIONS[MUTATE] : null;
    if (MUTATE && !m) {
        process.stderr.write(`모르는 변이: ${MUTATE} (--mutate=list)\n`);
        process.exit(2);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-check-'));
    fs.writeFileSync(path.join(dir, 'zxing-fake.js'), ZXING_FAKE);
    ['scanner.js', 'scan-calc.js'].forEach((f) => {
        let code = fs.readFileSync(path.join(SRC, f), 'utf8');
        if (m && f === m.file) {
            // 한 결함이 여러 줄에 흩어져 있으면 edits 로 여러 곳을 함께 고친다
            (m.edits ?? [{ find: m.find, to: m.to }]).forEach((e) => {
                if (!code.includes(e.find)) {
                    process.stderr.write(`변이 지점을 찾지 못했다: ${MUTATE} (${f})\n`);
                    process.exit(2);
                }
                code = code.replace(e.find, e.to);
            });
        }
        if (f === 'scanner.js') {
            const before = code;
            code = code.replace(/'@zxing\/(browser|library)'/g, "'./zxing-fake.js'");
            if (code === before) {
                process.stderr.write('ZXing 임포트를 찾지 못했다 (가짜로 바꿀 수 없다)\n');
                process.exit(2);
            }
        }
        fs.writeFileSync(path.join(dir, f), code);
    });
    return dir;
}

/* -------------------------------- 가짜 실행 환경 -------------------------------- */

const realSetImmediate = setImmediate;

/** 가상 시계 - 실제로 기다리지 않고 수 분 분량의 스캔을 센다 */
let clock = 0;
let timerSeq = 0;
let timers = [];

function vSetTimeout(fn, ms, ...rest) {
    timerSeq += 1;
    const t = { id: timerSeq, at: clock + Math.max(0, Number(ms) || 0), fn, rest };
    timers.push(t);
    return t.id;
}

function vClearTimeout(id) {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
}

/** 마이크로태스크를 전부 흘려보낸다 (await 체인이 다음 타이머를 걸 기회를 준다) */
const flush = () => new Promise((r) => realSetImmediate(r));

/** 가상 시계를 `until` 까지 돌린다 */
async function advance(until) {
    for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = timers[0];
        if (!t || t.at > until) break;
        timers.shift();
        clock = Math.max(clock, t.at);
        t.fn(...t.rest);
        await flush();
    }
    clock = Math.max(clock, until);
    await flush();
}

const FORMATS = ['code_128', 'code_39', 'ean_13', 'qr_code', 'codabar', 'itf'];

/** 지금 돌고 있는 시나리오 (가짜 디코더·카메라가 여기를 본다) */
let sim = null;

class FakeDetector {
    constructor({ formats }) {
        this.formats = formats;
    }

    static getSupportedFormats() {
        return Promise.resolve([...FORMATS]);
    }

    detect() {
        // 🔑 현장 기기 재현 - nativeThrows: Play 바코드 모듈이 없어 매번 던진다 ·
        // nativeBlind: 던지지도 않고 늘 빈 배열만 준다 (전환 신호가 없는 쪽이 더 고약하다)
        const label = sim.nativeBlind ? null : sim.present(clock);
        const ok = Boolean(label) && sim.rnd() >= sim.failRate;
        const cost = ok ? sim.hitCost : sim.missCost;
        sim.decodes.push({ start: clock, end: clock + cost, hit: ok, after: sim.stopped });
        return new Promise((resolve, reject) => {
            // 중지하면 캔버스·트랙을 놓으므로 진행 중이던 디코딩이 던질 수 있다
            vSetTimeout(() => {
                if (sim.nativeThrows) {
                    reject(Object.assign(new Error('Barcode detection service unavailable'),
                        { name: 'NotSupportedError' }));
                    return;
                }
                if (sim.throwWhenStopped && sim.stopped) {
                    reject(new Error('캔버스가 사라졌다'));
                    return;
                }
                resolve(ok
                    ? [{ rawValue: label, boundingBox: { x: 0, y: 0, width: 10, height: 10 } }]
                    : []);
            }, cost);
        });
    }
}

function fakeCanvas() {
    return {
        width: 0,
        height: 0,
        getContext: () => ({
            drawImage() {},
            getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData() {},
        }),
    };
}

/**
 * 가짜 ZXing 디코딩 - 실제 API 가 **동기**라 기다릴 수 없으므로 가상 시계를 직접 민다.
 * 내장과 달리 `sim.zxingBlind` 가 아니면 라벨이 보이는 동안 항상 읽는다
 * (그림자 디코딩·전환이 실제로 인식을 되살리는지 세기 위해서다).
 */
function fakeZxing() {
    const label = sim.zxingBlind ? null : sim.present(clock);
    const cost = sim.zxingCost;
    sim.decodes.push({ start: clock, end: clock + cost, hit: Boolean(label), zxing: true });
    sim.zxingCalls += 1;
    clock += cost;
    return label ? { getText: () => label } : null;
}

function installGlobals() {
    const def = (k, v) => Object.defineProperty(globalThis, k, {
        value: v, writable: true, configurable: true,
    });
    // 강등·줌 실패 안내는 시나리오상 일부러 만드는 것이라 검사 출력에서 치운다
    console.warn = () => {};
    def('setTimeout', vSetTimeout);
    def('clearTimeout', vClearTimeout);
    def('performance', { now: () => clock });
    def('__zxing', fakeZxing);
    // 내장 인식기를 못 쓴다고 기억해 버리면 다음 시나리오가 전부 ZXing 으로 돈다 -
    // 시나리오마다 초기화한다 (브라우저의 localStorage 자리)
    def('localStorage', {
        store: new Map(),
        getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
        setItem(k, v) { this.store.set(k, String(v)); },
        removeItem(k) { this.store.delete(k); },
    });
    def('window', { BarcodeDetector: FakeDetector });
    def('document', {
        hidden: false,
        createElement: () => fakeCanvas(),
        addEventListener() {},
        removeEventListener() {},
    });
    def('navigator', {
        mediaDevices: {
            getUserMedia: (c) => {
                sim.opened += 1;
                sim.constraints.push(c);
                return new Promise((resolve, reject) => {
                    vSetTimeout(() => (sim.openFail
                        ? reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
                        : resolve(makeStream())), sim.openMs);
                });
            },
        },
    });
}

function makeTrack() {
    const track = {
        readyState: 'live',
        stopped: false,
        getCapabilities: () => sim.caps,
        getSettings: () => ({ zoom: 1 }),
        applyConstraints(c) {
            sim.applied.push(c);
            return sim.applyFail ? Promise.reject(new Error('nope')) : Promise.resolve();
        },
        stop() {
            track.stopped = true;
            track.readyState = 'ended';
        },
    };
    sim.tracks.push(track);
    return track;
}

function makeStream() {
    const track = makeTrack();
    return { getVideoTracks: () => [track], getTracks: () => [track] };
}

/** 가짜 프리뷰 - `requestVideoFrameCallback` 이 있는 기기를 흉내낸다 */
function makeVideo(rvfc = true) {
    const v = {
        videoWidth: 1920,
        videoHeight: 1080,
        hidden: true,
        srcObject: null,
        muted: false,
        clientWidth: 360,
        clientHeight: 320,
        setAttribute() {},
        play: () => Promise.resolve(),
        addEventListener() {},
        removeEventListener() {},
    };
    if (rvfc) {
        v.requestVideoFrameCallback = (cb) => {
            sim.framesAt.push(clock);   // 루프가 다음 프레임을 예약한 시각
            return vSetTimeout(cb, 16);
        };
        v.cancelVideoFrameCallback = (id) => vClearTimeout(id);
    }
    return v;
}

/* --------------------------------- 시나리오 --------------------------------- */

let seed = SEED;
function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
}
const pick = (n) => Math.floor(rnd() * n);

const DIR = sourceDir();
const { createScanner, TUNE } = await import(url.pathToFileURL(
    path.join(DIR, 'scanner.js')).href);
const calc = await import(url.pathToFileURL(path.join(DIR, 'scan-calc.js')).href);

installGlobals();

/**
 * 한 시나리오를 돌린다.
 * @param {object} opt present(t)=보이는 라벨 · hitCost · missCost · failRate · ms · stopAt
 */
async function run(opt) {
    clock = 0;
    timers = [];
    localStorage.store.clear();     // 엔진 기억은 시나리오마다 처음부터 (기기를 새로 잡는다)
    sim = {
        present: opt.present,
        hitCost: opt.hitCost ?? 30,
        missCost: opt.missCost ?? 30,
        failRate: opt.failRate ?? 0,
        openMs: opt.openMs ?? 0,
        openFail: opt.openFail ?? false,
        applyFail: opt.applyFail ?? false,
        caps: opt.caps ?? { focusMode: ['continuous'], torch: true },
        rnd: opt.rnd ?? rnd,
        decodes: [],
        codes: [],
        framesAt: [],
        applied: [],
        constraints: [],
        tracks: [],
        opened: 0,
        stopped: false,
        throwWhenStopped: opt.throwWhenStopped ?? false,
        /** 내장 인식기 고장 모드 - 던지거나(throws) 늘 빈 결과(blind) */
        nativeThrows: opt.nativeThrows ?? false,
        nativeBlind: opt.nativeBlind ?? false,
        zxingBlind: opt.zxingBlind ?? false,
        zxingCost: opt.zxingCost ?? 40,
        zxingCalls: 0,
    };
    const video = makeVideo(opt.rvfc ?? true);
    const sc = createScanner(video, (code) => sim.codes.push({ at: clock, code }));
    const started = sc.start().catch(() => {});

    if (opt.stopAt != null) {
        await advance(opt.stopAt);
        sim.stopped = true;
        sc.stop();
        sim.stopAtClock = clock;
    }
    await advance(opt.ms ?? 6000);
    await started;
    if (opt.stopAt == null) sc.stop();
    return { sim, sc, video };
}

/* ---------------------------------- 채점 ---------------------------------- */

const fails = {
    S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0, S7: 0, S8: 0, S9: 0, S10: 0, S11: 0, EX: 0,
};
const cover = {
    hold: 0, gapRuns: 0, slowTick: 0, stopMid: 0, stopThrow: 0,
    downgrade: 0, zoom1: 0, consensus: 0, swap: 0, shadow: 0,
};
const first = {};
function note(k, msg) {
    fails[k] += 1;
    if (!first[k]) first[k] = msg;
}

/** 한 tick 안의 디코딩을 묶는다 (같은 tick 의 다음 ROI 는 시간 공백 없이 이어진다) */
function ticksOf(decodes) {
    const out = [];
    decodes.forEach((d) => {
        const cur = out[out.length - 1];
        if (cur && cur[cur.length - 1].end === d.start) cur.push(d);
        else out.push([d]);
    });
    return out;
}

/**
 * S4 - 예산 검사는 모든 시나리오에서 함께 센다.
 * 🔑 예산은 경로마다 다르다 - ZXing 으로만 이뤄진 tick 은 ZXing 예산으로 본다.
 * (내장 ROI + 그림자 디코딩이 섞인 tick 은 내장 예산이다 - 그림자는 예산이 남을 때만 붙는다)
 */
function checkBudget(tag, decodes) {
    ticksOf(decodes).forEach((t) => {
        const budget = t.every((d) => d.zxing) ? TUNE.budgetZxingMs : TUNE.budgetNativeMs;
        const total = t.reduce((m, d) => m + (d.end - d.start), 0);
        const lastOne = t[t.length - 1].end - t[t.length - 1].start;
        if (t.length > 1) cover.slowTick += 1;
        // 마지막 1회를 시작하기 전까지는 예산 안이어야 한다 (= 총시간 ≤ 예산 + 1회분)
        if (t.length > 1 && total - lastOne >= budget) {
            note('S4', `${tag} tick ${t.length}회 총 ${total}ms `
                + `(마지막 1회 ${lastOne}) - 예산 ${budget} 을 넘고도 더 열었다`);
        }
    });
}

/* ------------------------------- S1 · S2 · S4 ------------------------------- */

/** 라벨이 계속 보이는 동안 - repeatMs 주기보다 자주 세면 안 된다 */
async function s1(i) {
    const ms = 3000 + pick(6000);
    const { sim: s } = await run({
        present: () => 'PO-1',
        hitCost: 10 + pick(60),
        missCost: 10 + pick(60),
        ms,
    });
    const max = Math.floor(ms / TUNE.repeatMs) + 1;
    if (s.codes.length > max) note('S1', `#${i} ${ms}ms 동안 ${s.codes.length}건 (상한 ${max})`);
    if (!s.codes.length) note('S1', `#${i} ${ms}ms 동안 한 건도 못 셌다`);
    // 연속 계수 간격도 repeatMs 미만이면 안 된다
    for (let k = 1; k < s.codes.length; k += 1) {
        const gap = s.codes[k].at - s.codes[k - 1].at;
        if (gap < TUNE.repeatMs - 1) note('S1', `#${i} 계수 간격 ${Math.round(gap)}ms`);
    }
    checkBudget(`S1#${i}`, s.decodes);
}

/**
 * 🔑 핵심 - 라벨 **한 장**을 든 채 디코딩이 랜덤하게 실패해도 1건이어야 한다.
 * (2026-09-17: 실패가 몇 번 섞이면 "라벨을 치웠다" 로 오해해 2건이 되었다)
 */
async function s2hold(i) {
    // 🔑 문턱의 하한(reArmMs 1.5초)보다 짧게 든다 - 이 안에서 2건이면 무조건 결함이다
    const hold = 600 + pick(850);
    const { sim: s } = await run({
        present: (t) => (t < hold ? 'PO-1' : null),
        hitCost: 10 + pick(40),
        missCost: 20 + pick(380),           // 느린 기기(iOS·ZXing)까지 흉내낸다
        failRate: 0.15 + rnd() * 0.7,
        ms: hold + 3000,
    });
    cover.hold += 1;
    if (s.codes.length > 1) {
        note('S2', `#${i} 한 장을 ${hold}ms 들었는데 ${s.codes.length}건 `
            + `(실패율 ${s.failRate.toFixed(2)} · 미검출 ${s.missCost}ms)`);
    }
}

/** 라벨을 확실히 떼었다 대면(빈 시간 3초) 그 수만큼 정확히 세어져야 한다 */
async function s2seq(i) {
    const n = 2 + pick(3);
    const hold = 700 + pick(500);
    const gap = 3000;
    const cycle = hold + gap;
    const { sim: s } = await run({
        present: (t) => (t % cycle < hold && t < n * cycle ? 'PO-1' : null),
        hitCost: 10 + pick(40),
        missCost: 20 + pick(200),
        failRate: rnd() * 0.5,
        ms: n * cycle + 500,
    });
    cover.gapRuns += 1;
    if (s.codes.length > n) note('S2', `#${i} ${n}장을 찍었는데 ${s.codes.length}건 (과다)`);
    if (s.codes.length < 1) note('S2', `#${i} ${n}장을 찍었는데 한 건도 못 셌다`);
    checkBudget(`S2#${i}`, s.decodes);
}

/* ------------------------------------ S3 ------------------------------------ */

/**
 * 성공 프레임이 싸다는 이유로 `reArmGap` 이 줄면 안 된다.
 *
 * 시나리오: 라벨을 계속 든 채 **처음에 한 번 읽히고**, 그 뒤 1.7초 동안 계속 실패한 뒤
 * 다시 읽힌다. 미검출 1회가 400ms 이므로 올바른 문턱은 max(1500, 5×400)=2000ms 라
 * 1.7초 공백은 "치웠다" 가 아니다 → **1건**.
 * 성공(10ms)을 평균에 섞으면 문턱이 1500ms 대로 내려가 **2건**이 된다.
 */
async function s3() {
    let calls = 0;
    const { sim: s } = await run({
        present: () => 'PO-1',
        hitCost: 10,
        missCost: 400,
        // 첫 호출만 성공, 그 뒤 1.7초 동안 실패, 이후 다시 성공
        rnd: () => {
            calls += 1;
            return calls === 1 || clock > 1700 ? 1 : 0;
        },
        failRate: 0.5,
        ms: 2400,
    });
    if (s.codes.length !== 1) {
        note('S3', `라벨을 든 채 1.7초 미검출인데 ${s.codes.length}건 (1건이어야 한다)`);
    }

    // 순수 함수 불변식 - 성공은 평균에 들어가지 않고, 문턱은 절대 reArmMs 아래로 안 간다
    for (let k = 0; k < 400; k += 1) {
        const c = rnd() * 600;
        const spent = rnd() * 600;
        if (calc.nextCost(c, spent, true, TUNE) !== c) note('S3', 'nextCost 가 성공을 반영했다');
        const g = calc.reArmGap(calc.nextCost(c, spent, false, TUNE), TUNE);
        if (g < TUNE.reArmMs) note('S3', `reArmGap ${g} < reArmMs`);
        // 성공을 아무리 섞어도 문턱이 줄지 않는다
        let mixed = c;
        for (let j = 0; j < 10; j += 1) mixed = calc.nextCost(mixed, 5, true, TUNE);
        if (calc.reArmGap(mixed, TUNE) < calc.reArmGap(c, TUNE)) {
            note('S3', '성공 프레임을 섞었더니 문턱이 줄었다');
        }
    }
}

/* ------------------------------------ S5 ------------------------------------ */

/** 준비 중·디코딩 중 어디서 멈춰도 콜백·디코딩이 더 나오면 안 된다 */
async function s5(i) {
    const stopAt = pick(2500);
    const { sim: s, video } = await run({
        present: () => 'PO-1',
        hitCost: 20 + pick(120),
        missCost: 20 + pick(120),
        openMs: pick(800),
        ms: stopAt + 5000,
        stopAt,
    });
    cover.stopMid += 1;
    const after = s.codes.filter((c) => c.at > s.stopAtClock);
    if (after.length) note('S5', `#${i} 중지 ${stopAt}ms 뒤에 ${after.length}건이 더 들어왔다`);
    const late = s.decodes.filter((d) => d.start > s.stopAtClock);
    if (late.length) note('S5', `#${i} 중지 뒤에도 디코딩이 ${late.length}회 돌았다`);
    if (s.tracks.some((t) => !t.stopped)) note('S5', `#${i} 카메라 트랙이 살아 있다`);
    if (video.srcObject) note('S5', `#${i} 프리뷰에 스트림이 남아 있다`);
    if (timers.length) note('S5', `#${i} 타이머가 ${timers.length}개 남았다`);
    if (s.framesAt.some((t) => t > s.stopAtClock)) {
        note('S5', `#${i} 중지 뒤에 다음 프레임을 예약했다 (루프가 살아 있다)`);
    }
}

/**
 * 중지하는 순간 디코딩이 **예외를 던져도** 루프가 되살아나면 안 된다.
 * (중지하면 캔버스·트랙을 놓으므로 진행 중이던 디코딩이 던지는 일이 실제로 있다.
 *  예외 경로에 `running` 재확인이 없으면 catch 뒤에서 다음 프레임 타이머를 다시 건다)
 */
async function s5throw(i) {
    const stopAt = 300 + pick(1200);
    const { sim: s, video } = await run({
        present: () => 'PO-1',
        hitCost: 60 + pick(200),
        missCost: 60 + pick(200),
        ms: stopAt + 5000,
        stopAt,
        throwWhenStopped: true,
    });
    cover.stopThrow += 1;
    if (s.codes.filter((c) => c.at > s.stopAtClock).length) {
        note('S5', `#${i} 예외 경로 - 중지 뒤에 코드가 들어왔다`);
    }
    if (s.decodes.filter((d) => d.start > s.stopAtClock).length) {
        note('S5', `#${i} 예외 경로 - 중지 뒤에도 디코딩이 돌았다`);
    }
    if (timers.length) note('S5', `#${i} 예외 경로 - 타이머가 ${timers.length}개 남았다`);
    if (video.srcObject) note('S5', `#${i} 예외 경로 - 프리뷰에 스트림이 남아 있다`);
    // 🔑 예외가 나도 catch 뒤에서 다음 프레임을 예약하면 안 된다 (좀비 루프)
    if (s.framesAt.some((t) => t > s.stopAtClock)) {
        note('S5', `#${i} 예외 경로 - 중지 뒤에 다음 프레임을 예약했다`);
    }
}

/** 연타로 시작해도 스트림은 하나만 열린다 */
async function s5burst() {
    clock = 0;
    timers = [];
    sim = {
        present: () => null,
        hitCost: 20,
        missCost: 20,
        failRate: 1,
        openMs: 300,
        caps: {},
        rnd,
        decodes: [],
        codes: [],
        framesAt: [],
        applied: [],
        constraints: [],
        tracks: [],
        opened: 0,
        stopped: false,
    };
    const video = makeVideo();
    const sc = createScanner(video, () => {});
    sc.start().catch(() => {});
    sc.start().catch(() => {});
    sc.start().catch(() => {});
    await advance(2000);
    if (sim.opened !== 1) note('S5', `연타 시작에 카메라가 ${sim.opened}번 열렸다`);
    sc.stop();
    await advance(3000);
    if (sim.tracks.some((t) => !t.stopped)) note('S5', '연타 뒤 트랙이 남았다');
}

/* ------------------------------------ S6 ------------------------------------ */

/** 예산을 계속 넘겨도 강등은 한 번뿐이고, 되돌리지 않는다 */
async function s6() {
    const { sim: s } = await run({
        present: () => null,
        hitCost: 500,
        missCost: 500,             // 예산(120ms)을 매번 크게 넘긴다
        failRate: 1,
        ms: 12000,
    });
    const down = s.applied.filter((c) => c.width || c.height);
    cover.downgrade += down.length;
    if (down.length !== 1) note('S6', `강등이 ${down.length}회 (1회여야 한다)`);
    if (down[0] && down[0].width?.ideal !== TUNE.downSize.width) {
        note('S6', `강등 해상도가 ${JSON.stringify(down[0])}`);
    }

    // 빠른 기기는 강등하지 않는다
    const fast = await run({
        present: () => null,
        hitCost: 10,
        missCost: 10,
        failRate: 1,
        ms: 8000,
    });
    if (fast.sim.applied.some((c) => c.width || c.height)) {
        note('S6', '빠른 기기인데 강등했다');
    }

    // 순수 함수 - 2회 연속에서만, 한 번 내리면 끝
    if (calc.shouldDowngrade(1, false)) note('S6', '1회 초과에 강등했다');
    if (!calc.shouldDowngrade(2, false)) note('S6', '2회 연속인데 강등하지 않았다');
    if (calc.shouldDowngrade(9, true)) note('S6', '이미 강등했는데 또 내렸다');
    if (calc.nextOverrun(3, 10, 120) !== 0) note('S6', '예산 안에 들어왔는데 초과가 안 풀렸다');
}

/* ------------------------------------ S7 ------------------------------------ */

/** ROI 계획 - 가로 하한 · 순열 · 1순위만 좁은 포맷 · 전처리 시점 */
function s7() {
    [true, false].forEach((native) => {
        const base = native ? TUNE.roiNative : TUNE.roiZxing;
        for (let miss = 0; miss <= 40; miss += 1) {
            const plan = calc.roiPlan(native, miss, TUNE);
            if (plan.length !== base.length) {
                note('S7', `계획 길이 ${plan.length} ≠ ${base.length}`);
            }
            plan.forEach((r, i) => {
                if (r.w < calc.ROI_MIN_W - 1e-9) {
                    note('S7', `가로 ${r.w} < ${calc.ROI_MIN_W} (quiet zone 이 잘린다)`);
                }
                if (r.w > 1 || r.h > 1 || r.h <= 0) note('S7', `ROI 범위 밖 ${r.w}×${r.h}`);
                if ((i === 0) === r.wide) note('S7', `1순위/후순위 포맷 폭이 뒤집혔다 (i=${i})`);
                const wantPre = !native && miss >= TUNE.preMissN;
                if (r.pre !== wantPre) note('S7', `전처리 시점이 다르다 (miss=${miss})`);
            });
            // 같은 ROI 집합을 돌려 쓰는지 (하나도 빠뜨리지 않는다)
            const key = (r) => `${r.w}:${r.h}`;
            const got = new Set(plan.map(key));
            base.forEach((r) => {
                if (!got.has(key(r))) note('S7', `계획에서 ROI ${key(r)} 가 빠졌다`);
            });
        }
    });
    // 계획 마지막은 어느 경로든 "덜 좁은" 시도가 남아 있어야 한다
    if (calc.stepBudget(true, TUNE) >= calc.stepBudget(false, TUNE)) {
        note('S7', '내장 경로 예산이 ZXing 보다 크다');
    }
}

/* ------------------------------------ S8 ------------------------------------ */

/** 줌 - 못 쓰는 기기에는 빈 배열, 쓰는 기기는 범위 안 오름차순 */
function s8() {
    if (calc.zoomSteps(null, TUNE).length) note('S8', '줌 능력이 없는데 단계를 줬다');
    if (calc.zoomSteps({ min: 1, max: 1 }, TUNE).length) note('S8', 'min=max 인데 단계를 줬다');
    if (calc.clampZoom(3, null) !== null) note('S8', '줌 능력이 없는데 값을 줬다');
    for (let k = 0; k < 500; k += 1) {
        // 🔑 min 이 3 이상인 기기도 넣는다 - 단계 [1,2,3] 이 전부 min 으로 뭉쳐
        // **쓸 수 있는 단계가 1개**가 되는 경우가 여기서만 나온다 (버튼을 숨겨야 한다)
        const min = [0.5, 1, 2, 3, 4][pick(5)];
        const max = min + rnd() * 8;
        const caps = { min, max, step: [0, 0.1, 0.5, 1][pick(4)] };
        const steps = calc.zoomSteps(caps, TUNE);
        if (steps.length === 1) {
            note('S8', `쓸 수 있는 단계가 1개뿐인데 빈 배열이 아니다 ${JSON.stringify(steps)}`
                + ` (caps ${min}~${max.toFixed(1)})`);
        }
        cover.zoom1 += steps.length === 0 && Math.max(1, min) >= 3 ? 1 : 0;
        steps.forEach((z, i) => {
            if (z < Math.max(1, min) - 1e-9 || z > max + 1e-9) {
                note('S8', `단계 ${z} 가 범위 [${min}, ${max}] 밖`);
            }
            if (i && z <= steps[i - 1]) note('S8', '단계가 오름차순이 아니다');
        });
        const v = calc.clampZoom(min + rnd() * (max - min) * 2, caps);
        if (v < min - 1e-9 || v > max + 1e-9) note('S8', `클램프 결과 ${v} 가 범위 밖`);
    }
    // 가이드 박스는 상자를 벗어나지 않는다 (아래 s8stop 은 실제 루프를 돌린다)
    for (let k = 0; k < 200; k += 1) {
        const r = calc.aimRect(calc.AIM_ROI, 640 + pick(2000), 360 + pick(1100),
            200 + pick(400), 150 + pick(400));
        if (r.left < -1e-9 || r.top < -1e-9) note('S8', '가이드 박스가 상자를 넘었다');
    }
}

/**
 * 줌 안정화(300ms) 를 기다리는 중에 멈춰도 `setZoomRaw` 는 **끝나야 한다.**
 * 끝나지 않으면 UI(`scanPreview`)의 `zoomBusy` 가 영영 true 로 남아 다음부터 줌이 죽는다.
 */
async function s8stop() {
    const zoomCaps = { zoom: { min: 1, max: 5, step: 0 }, focusMode: ['continuous'] };
    clock = 0;
    timers = [];
    sim = {
        present: () => null,
        hitCost: 20,
        missCost: 20,
        failRate: 1,
        openMs: 0,
        caps: zoomCaps,
        rnd,
        decodes: [],
        codes: [],
        framesAt: [],
        applied: [],
        constraints: [],
        tracks: [],
        opened: 0,
        stopped: false,
    };
    const video = makeVideo();
    const sc = createScanner(video, () => {});
    sc.start().catch(() => {});
    await advance(300);
    if (!sc.canZoom()) {
        note('S8', '줌을 노출한 기기인데 canZoom 이 false 다');
        sc.stop();
        return;
    }
    let done = false;
    sc.setZoomRaw(3).then(() => {
        done = true;
    });
    await advance(clock + 10);      // applyConstraints 를 지나 안정화 대기에 들어간 시점
    sc.stop();
    await advance(clock + 3000);
    if (!done) note('S8', '줌 안정화 중에 멈췄더니 setZoomRaw 가 끝나지 않았다 (줌이 잠긴다)');
    if (timers.length) note('S8', `줌 시나리오에 타이머가 ${timers.length}개 남았다`);
}

/* ------------------------------------ S9 ------------------------------------ */

/**
 * 합의(consensus)는 **연속** 프레임을 뜻한다.
 * 미검출이 끼었는데도 계수를 이어 가면 "연속 2프레임" 이 아무 것도 막지 못한다
 * (2026-09-17 의 "단위가 다른 조건 둘을 나란히 두면 한쪽이 없는 것과 같다" 와 같은 결함).
 */
async function s9() {
    const keep = TUNE.consensus;
    TUNE.consensus = 2;
    try {
        // 성공·실패가 한 번씩 번갈아 온다 = 연속 2프레임은 **한 번도** 없다
        let n = 0;
        const alt = await run({
            present: () => 'PO-1',
            hitCost: 20,
            missCost: 200,          // 미검출 1회로 예산(120)을 넘겨 tick 당 디코딩 1회
            failRate: 0.5,
            rnd: () => {
                n += 1;
                return n % 2 ? 1 : 0;
            },
            ms: 9000,
        });
        cover.consensus += 1;
        if (alt.sim.codes.length) {
            note('S9', `연속 2프레임이 한 번도 없는데 ${alt.sim.codes.length}건을 셌다`);
        }
        // 연속으로 잘 읽히면 종전대로 세어진다 (합의를 켜도 못 쓰게 되면 안 된다)
        const ok = await run({
            present: () => 'PO-1',
            hitCost: 20,
            missCost: 200,
            failRate: 0,
            ms: 9000,
        });
        if (!ok.sim.codes.length) note('S9', '연속 검출인데 합의=2 에서 한 건도 못 셌다');
    } finally {
        TUNE.consensus = keep;
    }
}

/* --------------------------------- S10 · S11 --------------------------------- */

/**
 * 🔑 내장 인식기가 **예외를 던지는** 기기 (안드로이드 크롬 · Play 바코드 모듈 없음).
 * 예전에는 `console.warn` 만 찍고 같은 인식기로 계속 돌아 **영원히 미검출**이었다.
 * 지금은 첫 예외에서 ZXing 으로 갈아타고 인식이 되살아나야 한다.
 */
async function s10() {
    // 라벨을 떼었다 대는 것을 n 번 반복한다 (과다 계수까지 함께 센다)
    const n = 3;
    const hold = 900;
    const gap = 3000;
    const cycle = hold + gap;
    const { sim: s, sc } = await run({
        present: (t) => (t % cycle < hold && t < n * cycle ? 'PO-1' : null),
        nativeThrows: true,
        missCost: 30,
        zxingCost: 40,
        ms: n * cycle + 1000,
    });
    cover.swap += 1;
    if (!s.zxingCalls) note('S10', '내장이 예외를 던졌는데 ZXing 을 부르지 않았다');
    if (!s.codes.length) note('S10', `전환 뒤에도 한 건도 못 셌다 (ZXing 호출 ${s.zxingCalls})`);
    // 🔑 **첫 예외에서 곧바로** 갈아타야 한다. 그림자 디코딩(4초 뒤)이 대신 건져 주는 것에
    // 기대면 현장에서는 「한참 비춰야 읽힌다」 가 된다
    if (s.codes[0] && s.codes[0].at >= TUNE.shadowAfterMs) {
        note('S10', `첫 인식이 ${Math.round(s.codes[0].at)}ms 로 늦다`
            + ' (예외 직후가 아니라 그림자 디코딩이 건졌다)');
    }
    if (s.codes.length > n) note('S10', `${n}장을 찍었는데 ${s.codes.length}건 (과다)`);
    if (sc.engine() !== 'zxing') note('S10', `전환했는데 engine()=${sc.engine()}`);
    if (localStorage.getItem('tpl_scan_engine') !== 'zxing') {
        note('S10', '전환했는데 다음 실행을 위한 기억이 남지 않았다');
    }
    checkBudget('S10', s.decodes);
}

/**
 * 🔑 내장 인식기가 **던지지도 않고 늘 빈 결과**인 기기.
 * 오류가 없으니 전환 신호도 없다 - 「한참 못 잡는 것」 자체를 신호로 보고 같은 프레임을
 * ZXing 으로도 봐서(그림자 디코딩) 읽고, 그것이 쌓이면 갈아탄다.
 * 세는 것: 그림자가 실제로 붙는가 · 읽히는가 · 갈아탔는가 · **라벨 수보다 많이 세지 않는가**.
 */
async function s11() {
    const n = 6;
    const hold = 1200;
    const cycle = hold + 3000;
    const first = TUNE.shadowAfterMs + cycle;      // 그림자가 붙기 전 구간은 못 읽는다
    const { sim: s, sc } = await run({
        present: (t) => (t > first && t % cycle < hold ? 'PO-1' : null),
        nativeBlind: true,
        missCost: 5,                 // 빈 결과는 빠르게 온다 (예산이 남아야 그림자가 붙는다)
        zxingCost: 40,
        ms: first + n * cycle,
    });
    cover.shadow += 1;
    if (!s.decodes.some((d) => d.zxing)) {
        note('S11', '내장이 늘 빈 결과인데 그림자 디코딩을 한 번도 안 했다');
    }
    if (!s.codes.length) note('S11', '그림자 디코딩으로도 한 건도 못 셌다');
    if (sc.engine() !== 'zxing') note('S11', `ZXing 만 읽는데 engine()=${sc.engine()}`);
    // 🔑 전환 전후를 합쳐 라벨 수를 넘지 않아야 한다 (전환이 계수를 흔들지 않는다)
    if (s.codes.length > n) note('S11', `${n}장을 찍었는데 ${s.codes.length}건 (과다)`);
    if (s.codes.length < n - 1) {
        note('S11', `${n}장 중 ${s.codes.length}건만 셌다 (그림자·전환 뒤에도 못 읽는다)`);
    }
    checkBudget('S11', s.decodes);
}

/**
 * 🔑 그림자 디코딩은 **느리다**. 그 시간이 `cost` 에 들어가야 중복 판정 문턱
 * (`reArmGap = max(reArmMs, reArmFrames × cost)`)이 함께 커진다.
 * 빼 버리면 「디코딩이 느려 몇 번 건너뛴 것」이 「라벨을 치웠다」 로 오해되어
 * **한 파렛트가 2건**이 된다 (2026-09-17 사고와 같은 모양 · 이번엔 ZXing 이 아니라 그림자).
 *
 * 라벨을 0.5초 대고 → 1.6초 떼고 → 다시 댄다. 느린 디코더의 올바른 문턱은
 * 5×500 = 2500ms 라 1.6초 공백은 「치웠다」가 아니다. 공백이 문턱보다 짧으므로
 * **다음 1건은 `repeatMs`(2.5초)가 열려야만** 나올 수 있다 - 계수 간격으로 센다.
 */
async function s11gap() {
    const keep = {
        after: TUNE.shadowAfterMs, every: TUNE.shadowEveryN, hits: TUNE.shadowSwitchHits,
    };
    // 그림자 구간에 머무르게 둔다 (전환해 버리면 재 볼 것이 없다)
    TUNE.shadowAfterMs = 0;
    TUNE.shadowEveryN = 1;
    TUNE.shadowSwitchHits = 99;
    try {
        const { sim: s } = await run({
            present: (t) => (t < 500 || t >= 2100 ? 'PO-1' : null),
            nativeBlind: true,
            missCost: 5,
            zxingCost: 500,          // 느린 기기 - 문턱이 자동으로 2.5초까지 커져야 한다
            ms: 6000,
        });
        if (!s.codes.length) note('S11', '느린 그림자 시나리오에서 한 건도 못 셌다');
        for (let k = 1; k < s.codes.length; k += 1) {
            const gap = s.codes[k].at - s.codes[k - 1].at;
            if (gap < TUNE.repeatMs - 1) {
                note('S11', `느린 그림자 디코딩에서 계수 간격이 ${Math.round(gap)}ms`
                    + ' (공백 1.6초 < 문턱 2.5초라 repeatMs 전에는 셀 수 없다)');
            }
        }
    } finally {
        TUNE.shadowAfterMs = keep.after;
        TUNE.shadowEveryN = keep.every;
        TUNE.shadowSwitchHits = keep.hits;
    }
}

/* ---------------------------------- 실행 ---------------------------------- */

try {
    for (let i = 0; i < TOTAL; i += 1) {
        await s1(i);
        await s2hold(i);
        if (i % 3 === 0) await s2seq(i);
        if (i % 2 === 0) await s5(i);
        if (i % 4 === 0) await s5throw(i);
    }
    await s3();
    await s5burst();
    await s6();
    s7();
    s8();
    await s8stop();
    await s9();
    await s10();
    await s11();
    await s11gap();
} catch (err) {
    note('EX', `${err.message}`);
    process.stderr.write(`${err.stack}\n`);
}

const bad = Object.values(fails).some(Boolean);
const lines = Object.entries(fails)
    .map(([k, v]) => `  ${k}: ${v}건${v ? `   예: ${first[k]}` : ''}`);
process.stdout.write(`스캔 루프 불변식 검사 - 시나리오 ${TOTAL}회 (시드 ${SEED})`
    + `${MUTATE ? ` · 변이 ${MUTATE}` : ''}\n`);
process.stdout.write(`${lines.join('\n')}\n`);
process.stdout.write(`  커버리지 - 한 장 들기 ${cover.hold} · 떼었다 대기 ${cover.gapRuns} `
    + `· 중간 중지 ${cover.stopMid} · 예외 중지 ${cover.stopThrow} `
    + `· 다중 ROI tick ${cover.slowTick} · 강등 ${cover.downgrade} `
    + `· 줌 단계 1개 ${cover.zoom1} · 합의 ${cover.consensus} `
    + `· 엔진 전환 ${cover.swap} · 그림자 ${cover.shadow}\n`);
process.stdout.write(`${bad ? 'FAIL' : 'PASS'}\n`);
process.exitCode = bad ? 1 : 0;
