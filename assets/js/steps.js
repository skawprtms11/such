/**
 * 출고 처리 단계 계산.
 * 주문처리현황·출고주문처리·당일상차리스트가 같은 규칙을 쓰도록 한곳에 모았다.
 * 단계 완료 여부는 주문의 시각 필드(예: ship_done_at)에 값이 있는지로 판단한다.
 */
import { WORK_STEPS } from './config.js';

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
            if (s.cond === 'extra') return (order.extra_works ?? []).length > 0;
            if (s.cond === 'adjust') return adjust.has;
            if (s.cond === 'task') return task;
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

    const next = order.canceled_at ? -1 : steps.findIndex((s) => !s.done);
    return steps.map((s, i) => ({ ...s, current: i === next }));
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
