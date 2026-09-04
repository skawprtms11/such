/**
 * 출고 처리 단계 계산.
 * 주문처리현황·출고주문처리·당일상차리스트가 같은 규칙을 쓰도록 한곳에 모았다.
 * 단계 완료 여부는 주문의 시각 필드(예: ship_done_at)에 값이 있는지로 판단한다.
 */
import { WORK_STEPS, YN, LOAD_STATUS } from './config.js';

/**
 * @typedef {object} StepOpt
 * @property {boolean} [task] 추가작업 요청이 등록되어 있는지
 * @property {{has:boolean, done:boolean}} [adjust] 조정요청 등록·완료 여부
 */

/** 옵션 기본값 보정 */
function norm(opt = {}) {
    return {
        task: Boolean(opt.task),
        adjust: opt.adjust ?? { has: false, done: false },
    };
}

/**
 * 그 단계에 **착수했는지**.
 *   - 착수 시각 필드(`startAt`)가 있으면 그 값으로 본다 (출고작업)
 *   - 상차작업은 상차라벨을 한 장이라도 스캔했으면 착수로 본다
 *   - 나머지(검수·적치·요청·추가·조정)는 착수를 따로 기록하지 않으므로
 *     완료 전까지 진행중으로 표시하지 않는다
 */
function started(order, step) {
    if (!step) return false;
    if (step.startAt) return Boolean(order[step.startAt]);
    if (step.key === 'load') return Number(order.inspected ?? 0) > 0;
    return false;
}

/**
 * 해당 주문에서 화면에 보여야 할 단계 목록.
 *
 * `current` 는 **지금 진행중인 단계**(아직 끝나지 않은 첫 단계)다.
 * 화면에서 노란색으로 표시한다. 취소된 주문과 전부 끝난 주문에는 없다.
 *
 * @param {object} order 주문
 * @param {StepOpt} opt 조건부 단계 판단에 쓰는 값
 * @returns {Array<{key:string, label:string, done:boolean, doneAt:string|null,
 *                  current:boolean}>}
 */
export function visibleSteps(order, opt = {}) {
    const { task, adjust } = norm(opt);
    const steps = WORK_STEPS
        .filter((s) => {
            // 추가작업은 등록 시 '있음' 선택으로 판단한다 (옛 데이터는 extra_works 배열)
            if (s.cond === 'extra') {
                return order.extra_yn === YN.YES || (order.extra_works ?? []).length > 0;
            }
            if (s.cond === 'adjust') return adjust.has;
            if (s.cond === 'task') return task;
            if (s.cond === 'packing') return order.packing_yn === YN.YES;
            return true;
        })
        .map((s) => {
            // 조정작업은 주문 필드가 아니라 조정요청 확인 상태로 판단한다
            if (s.key === 'adjust') {
                return { key: s.key, label: s.label, done: adjust.done, doneAt: null };
            }
            return {
                key: s.key,
                label: s.label,
                done: Boolean(order[s.at]),
                doneAt: order[s.at] ?? null,
            };
        });

    // 🔑 진행중(노란색)은 **실제로 착수한 단계**에만 붙인다.
    // 앞 단계가 끝났다는 이유만으로 다음 단계가 노란색이 되면,
    // 아무도 손대지 않은 작업이 진행중으로 보인다.
    const next = order.canceled_at ? -1 : steps.findIndex((s) => !s.done);
    return steps.map((s, i) => ({
        ...s,
        current: i === next && started(order, WORK_STEPS.find((w) => w.key === s.key)),
    }));
}

/**
 * 단계 흐름을 화살표로 이어 그린다 (주문처리현황 · 출고주문처리가 함께 쓴다).
 * 완료는 초록, 지금 진행중인 단계는 노랑으로 표시된다.
 * @param {Array} steps `visibleSteps()` 결과
 * @param {(iso:string) => string} fmt 완료 일시 포맷 함수 (툴팁에 넣는다)
 */
export function stepsFlowHtml(steps, fmt) {
    return steps.map((s, i) => `
${i ? '<span class="steps__arrow">→</span>' : ''}
<span class="step ${s.done ? 'is-done' : ''} ${s.current ? 'is-current' : ''}"
      title="${s.doneAt ? fmt(s.doneAt) : s.current ? '진행중' : '미완료'}">${s.label}</span>`)
        .join('');
}

/** 상차작업을 제외한 모든 단계가 끝났는지 (당일상차리스트 진입 조건) */
export function readyToLoad(order, opt = {}) {
    return visibleSteps(order, opt)
        .filter((s) => s.key !== 'load')
        .every((s) => s.done);
}

/** 진행률(%) - 보이는 단계 기준 */
export function stepRate(order, opt = {}) {
    const steps = visibleSteps(order, opt);
    if (!steps.length) return 0;
    return Math.round((steps.filter((s) => s.done).length / steps.length) * 100);
}

/** 현재 단계 이름 (다음에 해야 할 단계). 전부 끝났으면 마지막 단계명 */
export function currentStep(order, opt = {}) {
    const steps = visibleSteps(order, opt);
    const next = steps.find((s) => !s.done);
    return next ? next.label : (steps.at(-1)?.label ?? '');
}

/**
 * 상차완료 판정 🔑
 * **단계 시각(`loaded_at`)과 상차 상태(`load_status`)가 모두 완료여야 완료다.**
 * 둘은 항상 같이 움직이지만(completeLoading · cancelLoading), 어긋난 데이터가
 * 남으면 화면마다 다르게 보인다. 판정을 한곳으로 모아 그런 건을 완료로 세지 않는다.
 */
export function loadDone(order) {
    return Boolean(order?.loaded_at) && order?.load_status === LOAD_STATUS.DONE;
}

/**
 * 상차 정보가 어긋난 건인지.
 * 한쪽만 완료라 상차완료라고도, 상차대기라고도 할 수 없는 상태다.
 * 당일상차리스트의 `상차완료 취소` 로 되돌린다.
 */
export function loadMismatch(order) {
    return Boolean(order?.loaded_at) !== (order?.load_status === LOAD_STATUS.DONE);
}
